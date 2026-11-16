#!/usr/bin/env bash
# Copies the site's data off this machine, into a restic repository (https://restic.net): see docs/self-hosting.md,
# "Backups". Run it in this folder's compose setup, as root or another member of the docker group:
#
#   backup.sh backup              tonight's copy: the database (a consistent copy, made while the site runs), Vault's
#                                 files, Yorg's, and the team's logo; then it forgets the copies it no longer keeps (on
#                                 Sundays, their data too)
#   backup.sh check               reads back a tenth of the repository (all of it over ten weeks), and restores the
#                                 database and 20 of Vault's files to check them: a backup is only as good as its
#                                 restore
#   backup.sh restore [<copy>]    puts a copy back (the latest, or one `snapshots` lists), with the site stopped; the
#                                 database it replaces stays in the volume, in backups/
#   backup.sh snapshots           lists the copies
#
# restic runs in compose.yaml's `backup` service, with the repository's keys in backup.env, which the server never sees,
# so whoever took over the site couldn't erase the copies with them. restic encrypts everything before it leaves, and
# each copy adds only what changed: Vault's files never change, so a night adds just the new versions. Each run writes
# how it went into the volume, where Admin > People shows it, so a failure doesn't go unnoticed.
set -euo pipefail
cd "$(dirname "$0")"

SAMPLE=20 # Vault's files each check restores
STATUS=/data/backups/offsite.json
DATABASE_COPY=/data/backups/yjsp.db # what the repository keeps of the database

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# restic, in the backup service, with the volume at /data. Never from this script's input, which a loop may be reading.
restic() { docker compose --progress quiet run --rm -T backup "$@" </dev/null; }

# Python in the server's image, with the volume, as the site's own user: it has SQLite, which this machine may not.
server_python() { docker compose --progress quiet run --rm --no-deps -T server python "$@"; }

# Records how a step went where Admin > People reads it, keeping what the other steps recorded: record KEY VALUE ...,
# an empty value for "none".
record() {
    server_python - "$STATUS" "$@" <<'PYTHON'
import json, os, sys

path, pairs = sys.argv[1], sys.argv[2:]
try:
    with open(path) as file:
        status = json.load(file)
except (OSError, ValueError):
    status = {}
for key, value in zip(pairs[::2], pairs[1::2]):
    status[key] = value or None
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path + ".tmp", "w") as file:
    json.dump(status, file, indent=2)
os.replace(path + ".tmp", path)
PYTHON
}

# Stops with what failed and the last thing it said, recorded for Admin > People: fail MODE WHAT
fail() {
    local detail
    detail=$(grep -v '^[[:space:]]*$' "$WORK/errors" 2>/dev/null | tail -n 1 || true)
    case $detail in # restic's --json says its errors in JSON: the message is what matters
    \{*'"message":"'*) detail=$(printf '%s' "$detail" | sed 's/.*"message":"\(.*\)"}$/\1/') ;;
    esac
    record "${1}_failed_at" "$(now)" "${1}_error" "$2${detail:+: $detail}" || true
    echo "backup.sh $1 failed: $2${detail:+: $detail}" >&2
    exit 1
}

# Runs a step, keeping its errors for the record and showing them: step MODE WHAT COMMAND...
step() {
    local mode=$1 what=$2
    shift 2
    if "$@" 2>"$WORK/errors"; then
        cat "$WORK/errors" >&2
    else
        cat "$WORK/errors" >&2
        fail "$mode" "$what"
    fi
}

# SQLite's own backup: whole and consistent while the site writes to it.
copy_database() {
    server_python - "$DATABASE_COPY" <<'PYTHON'
import os, sqlite3, sys

copy = sys.argv[1]
for folder in (os.path.dirname(copy), "/data/vault", "/data/yorg", "/data/brand"):
    os.makedirs(folder, exist_ok=True)
if os.path.exists(copy):
    os.remove(copy)
source = sqlite3.connect("file:/data/yjsp.db?mode=rw", uri=True)  # never a new, empty one
target = sqlite3.connect(copy)
source.backup(target)
target.close()
source.close()
PYTHON
}

backup_files() {
    restic backup --host yjsp --tag nightly --one-file-system --json --quiet \
        --exclude /data/vault/blobs/tmp \
        --exclude /data/yorg/tmp \
        --exclude /data/yorg/runs \
        --exclude /data/yorg/matplotlib \
        "$DATABASE_COPY" /data/vault /data/yorg /data/brand >"$WORK/summary"
}

# The copies kept: two weeks of nights, two months of weeks, two years of months. Their data goes on Sundays, and only
# what no kept copy needs (--max-unused unlimited), so a bucket whose lock rules keep data for days doesn't refuse it.
forget_old() {
    local prune=()
    [ "$(date -u +%u)" != 7 ] || prune=(--prune --max-unused unlimited)
    restic forget --host yjsp --tag nightly --keep-daily 14 --keep-weekly 8 --keep-monthly 24 ${prune[@]+"${prune[@]}"}
}

backup() {
    step backup "copying the database" copy_database
    step backup "backing up" backup_files
    local snapshot
    snapshot=$(grep -o '"snapshot_id":"[0-9a-f]*"' "$WORK/summary" | cut -d'"' -f4 | cut -c1-8)
    step backup "forgetting old copies" forget_old
    record backed_up_at "$(now)" snapshot "$snapshot" backup_failed_at "" backup_error ""
    echo "backup.sh: backed up as $snapshot"
}

# A different tenth of the data each week, so ten weeks read all of it back.
check_repository() {
    restic check --read-data-subset="$((10#$(date -u +%V) % 10 + 1))/10"
}

check_database() {
    restic dump --host yjsp --tag nightly latest "$DATABASE_COPY" | server_python -c '
import shutil, sqlite3, sys, tempfile

with tempfile.NamedTemporaryFile(suffix=".db") as copy:
    shutil.copyfileobj(sys.stdin.buffer, copy)
    copy.flush()
    verdict = sqlite3.connect(copy.name).execute("PRAGMA integrity_check").fetchone()[0]
if verdict != "ok":
    sys.exit(f"SQLite says: {verdict}")
'
}

# Each of Vault's files is a blob named by its SHA-256, so a restored one checks itself.
check_sample() {
    restic ls --host yjsp --tag nightly latest >"$WORK/listing"
    { grep -E '^/data/vault/blobs/.*/[0-9a-f]{64}$' "$WORK/listing" || true; } | shuf -n "$SAMPLE" >"$WORK/sample"
    local path hash
    while read -r path; do
        hash=$(restic dump --host yjsp --tag nightly latest "$path" | sha256sum | cut -d' ' -f1)
        [ "$hash" = "$(basename "$path")" ] || {
            echo "$path came back different: its SHA-256 is $hash" >&2
            return 1
        }
    done <"$WORK/sample"
}

check() {
    step verify "checking the repository" check_repository
    step verify "restoring the database" check_database
    step verify "restoring Vault's files" check_sample
    record verified_at "$(now)" verify_failed_at "" verify_error ""
    echo "backup.sh: the database and $(grep -c . "$WORK/sample" || true) of Vault's files restored and checked"
}

restore() {
    local copy=${1:-latest}
    # The site's own image first: on a new machine, the first container to use the volume makes it, and this one gives
    # /data to the site's user.
    server_python -c 'import os; os.makedirs("/data/backups", exist_ok=True)'
    restic snapshots --host yjsp --tag nightly "$copy"
    if [ -t 0 ]; then
        read -r -p "Put copy '$copy' back in place of this site's data? The site stops while it does. [y/N] " answer
        [ "$answer" = y ] || [ "$answer" = Y ] || exit 1
    fi
    docker compose stop server
    # The database there now goes aside, not away.
    server_python - <<'PYTHON'
import os, time

aside = time.strftime("/data/backups/replaced-%Y%m%d-%H%M%S", time.gmtime())
for name in ("yjsp.db", "yjsp.db-wal", "yjsp.db-shm"):
    if os.path.exists(f"/data/{name}"):
        os.makedirs(aside, exist_ok=True)
        os.replace(f"/data/{name}", f"{aside}/{name}")
if os.path.isdir(aside):
    print(f"backup.sh: the database that was there is in the volume's {aside.removeprefix('/data/')}")
PYTHON
    restic restore --host yjsp --tag nightly "$copy" --target /
    server_python -c "import os; os.replace('$DATABASE_COPY', '/data/yjsp.db')"
    docker compose up -d
    echo "backup.sh: copy '$copy' is back, and the site is starting"
}

case "${1:-}" in
backup) backup ;;
check) check ;;
restore) restore "${2:-}" ;;
snapshots) restic snapshots --host yjsp ;;
*)
    echo "usage: backup.sh backup|check|restore [<copy>]|snapshots" >&2
    exit 2
    ;;
esac
