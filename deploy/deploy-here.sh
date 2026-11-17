#!/usr/bin/env bash
# /usr/local/sbin/yjsp-deploy on the server, run as root by yjsp-deploy.service: see docs/deploying.md, "Deploying from
# the site". Keep this copy the same as the server's.
#
# Deploys main's newest commit, when the site's owner asks on Admin > People. The site can only start
# yjsp-deploy.service, which runs this with no arguments, so all it can ever ask for is main, deployed as this does it:
#
#   1. Fetches main from GitHub, and stops unless every job of CI (server, client, web, image) passed on that commit.
#   2. Builds the web app from it, in a folder of its own, as yjsp-build, a user that can't read the site's data: npm's
#      packages run as it.
#   3. Rehearses its migrations on a copy of the database, and stops if they fail. Until here, nothing has changed.
#   4. Switches over as deploy.sh does: backs the database up, stops the site, swaps the new version in, starts it, and
#      puts the old one back if it doesn't answer; then makes the demo again, if it's set up.
#
# How each deploy goes, and all it says, is in /var/lib/yjsp-deploy (deploys/<when it started>.json and .log; live.json,
# what's live), which the site reads for its Deploy card and can't write. One deploy runs at a time.
#
#   yjsp-deploy                               deploy main (what yjsp-deploy.service runs)
#   yjsp-deploy switch-over COMMIT [SUBJECT]  switch over to the version deploy.sh copied beside the site's
#                                             (/opt/yjsp/app/*.new): deploy.sh has the server's bash run this for it
#
# The test (server/tests/test_deploy_here.py) points the settings below at folders of its own, and GitHub, its API,
# systemctl, journalctl, curl, uv, and npm at stand-ins.
set -euo pipefail

REPOSITORY=${YJSP_DEPLOY_REPOSITORY:-zucalerega/eng_tools}
GIT_URL=${YJSP_DEPLOY_GIT_URL:-https://github.com/$REPOSITORY.git}
GITHUB_API=${YJSP_DEPLOY_GITHUB_API:-https://api.github.com}
APP=${YJSP_DEPLOY_APP:-/opt/yjsp/app}             # the site's code, web app, and help
SRV=${YJSP_DEPLOY_SRV:-/srv/yjsp}                 # its data, and the database's backups
STATE=${YJSP_DEPLOY_STATE:-/var/lib/yjsp-deploy}  # how deploys went, for the site to read
WORK=${YJSP_DEPLOY_WORK:-/var/cache/yjsp-deploy}  # main, as fetched, and the build
LOCK=${YJSP_DEPLOY_LOCK:-/run/lock/yjsp-deploy.lock}
LOCK_WAIT=${YJSP_DEPLOY_LOCK_WAIT:-10}            # seconds to wait for another deploy before stopping
NODE=${YJSP_DEPLOY_NODE:-/opt/yjsp/node/bin}      # Node.js 24, for the build
UV=${YJSP_DEPLOY_UV:-/usr/local/bin/uv}
SITE=${YJSP_DEPLOY_SITE:-http://127.0.0.1:8100}
DEMO=${YJSP_DEPLOY_DEMO:-http://127.0.0.1:8200}
WAIT=${YJSP_DEPLOY_WAIT:-30} # seconds for the site to answer once it's started
SITE_USER=${YJSP_DEPLOY_SITE_USER-yjsp}      # the site's own user, which its data belongs to
BUILDER=${YJSP_DEPLOY_BUILDER-yjsp-build}    # who builds the web app
CHECKS=(server client web image) # CI's jobs (.github/workflows/ci.yml), each of which must pass on what's deployed
KEEP=30                          # deploys whose records are kept

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

as_site() { if [ -n "$SITE_USER" ]; then runuser -u "$SITE_USER" -- "$@"; else "$@"; fi; }
as_builder() { if [ -n "$BUILDER" ]; then runuser -u "$BUILDER" -- "$@"; else "$@"; fi; }

# This deploy's record, which the Deploy card reads: record KEY VALUE [KEY VALUE ...], each value a string, empty for
# none, keeping the rest of what's there. Nothing without a record (deploy.sh's, on a server not set up for this).
record() {
    [ -n "${RECORD:-}" ] || return 0
    python3 - "$RECORD.json" "$@" <<'PYTHON'
import json, os, sys

path, pairs = sys.argv[1], sys.argv[2:]
try:
    with open(path) as file:
        status = json.load(file)
except (OSError, ValueError):
    status = {}
for key, value in zip(pairs[::2], pairs[1::2]):
    status[key] = value or None
with open(path + ".tmp", "w") as file:
    json.dump(status, file, indent=2)
os.chmod(path + ".tmp", 0o640)  # for the site's group, as the folder is
os.replace(path + ".tmp", path)
PYTHON
}

# Starts this deploy's record and its log, and keeps them current: begin SOURCE (site, or laptop: deploy.sh).
begin() {
    mkdir -p "$STATE/deploys"
    local id tries=0
    # Named for when it started, to the second, and claimed as it's named (noclobber): another deploy that starts in
    # the same second waits for the next, so no two have one name, and their names sort as they started.
    until id=$(date -u +%Y%m%d-%H%M%S) && (set -o noclobber && : >"$STATE/deploys/$id.log") 2>/dev/null; do
        tries=$((tries + 1))
        if [ "$tries" -ge 5 ]; then
            echo "Can't write a deploy's record in $STATE/deploys" >&2
            exit 1
        fi
        sleep 1
    done
    RECORD=$STATE/deploys/$id
    chmod 640 "$RECORD.log"
    record source "$1" started "$(now)"
    # Into its log as well as where it was going (the journal, or deploy.sh's SSH): if that goes (the SSH connection
    # drops), the log still gets everything, and the deploy goes on (-p), rather than stop halfway through switching.
    exec > >(tee -p -a "$RECORD.log") 2>&1
    # While it runs, its record is touched every 10 seconds, so the site can tell a deploy that's running from one that
    # stopped without saying so (killed, or the server restarted under it).
    # Its own output goes nowhere, so nothing it leaves running keeps the log's pipe open once the deploy has ended.
    (while sleep 10 && kill -0 $$ 2>/dev/null; do touch "$RECORD.json" 2>/dev/null || exit 0; done) </dev/null >/dev/null 2>&1 &
    BEAT=$!
    local old
    find "$STATE/deploys" -maxdepth 1 -name '*.log' -printf '%f\n' | sed 's/\.log$//' | LC_ALL=C sort | head -n -"$KEEP" |
        while read -r old; do rm -f "$STATE/deploys/$old.json" "$STATE/deploys/$old.log"; done
}

# What the deploy is doing now, said in its log and kept in its record: step NAME WORDS.
step() {
    echo "==> $2"
    record step "$1"
}

# How it ended: finish RESULT MESSAGE, the result deployed, stopped (nothing changed), rolled-back, or failed.
finish() {
    record result "$1" message "$2" finished "$(now)"
    FINISHED=1
}

# Stops the deploy before anything on the site has changed: stopped WHY.
stopped() {
    echo "Stopped: $1" >&2
    finish stopped "$1"
    exit 1
}

on_exit() {
    local status=$?
    if [ -n "${BEAT:-}" ]; then kill "$BEAT" 2>/dev/null || true; fi
    if [ -z "${FINISHED:-}" ]; then
        if [ -n "${TOUCHED:-}" ]; then
            finish failed "It broke while switching over (exit $status), and the site may be down: its log says where. docs/deploying.md, \"Rolling back\""
        else
            finish stopped "It broke before anything changed (exit $status): its log says where"
        fi
    fi
    # The build's folders are this deploy's only once it holds the lock: before, they may be a running one's.
    if [ -n "${BUILDING:-}" ]; then
        if [ -n "$BUILDER" ]; then pkill -KILL -u "$BUILDER" 2>/dev/null || true; fi
        rm -rf "${WORK:?}/build" "${WORK:?}/server"
    fi
}

# One deploy at a time, from the site or deploy.sh: whichever comes second stops.
take_lock() {
    exec 9>>"$LOCK"
    flock -w "$LOCK_WAIT" 9 || stopped "Another deploy is running, from the site or deploy.sh: wait for it to finish"
}

# What this needs, before it does anything.
preflight() {
    local tool
    for tool in git python3 sqlite3 curl "$UV"; do
        command -v "$tool" >/dev/null || stopped "$tool isn't installed on the server: docs/deploying.md, \"Deploying from the site\", says what's needed"
    done
    PATH=$NODE:$PATH command -v npm >/dev/null ||
        stopped "Node.js isn't installed in $NODE: docs/deploying.md, \"Deploying from the site\", says how"
}

# A commit's subject, or for a pull request's merge, the pull request's title and number: describe COMMIT.
describe() {
    local subject title merge='^Merge pull request #([0-9]+) '
    subject=$(git -C "$WORK/repo.git" log -1 --format=%s "$1")
    if [[ $subject =~ $merge ]]; then
        local number=${BASH_REMATCH[1]}
        title=$(git -C "$WORK/repo.git" log -1 --format=%b "$1" | grep -m 1 -v '^[[:space:]]*$' || true)
        if [ -n "$title" ]; then subject="$title (#$number)"; fi
    fi
    printf '%s\n' "$subject"
}

fetch() {
    step fetch "Fetching main from GitHub"
    mkdir -p "$WORK"
    if [ ! -d "$WORK/repo.git" ]; then git init --quiet --bare "$WORK/repo.git"; fi
    git -C "$WORK/repo.git" fetch --quiet --depth=1 --no-tags "$GIT_URL" +refs/heads/main:refs/heads/main ||
        stopped "Couldn't fetch main from GitHub ($GIT_URL): git says why, above"
    COMMIT=$(git -C "$WORK/repo.git" rev-parse --verify 'refs/heads/main^{commit}')
    SUBJECT=$(describe "$COMMIT")
    record commit "$COMMIT" subject "$SUBJECT"
    echo "main is ${COMMIT:0:7}: $SUBJECT"
}

# Every one of CI's jobs passed on this commit, as GitHub says (its check runs, the latest of each job's).
check_ci() {
    step checks "Checking that CI passed on ${COMMIT:0:7}"
    local said
    said=$(python3 - "$GITHUB_API" "$REPOSITORY" "$COMMIT" "${CHECKS[@]}" <<'PYTHON'
import json, sys, urllib.request

api, repository, commit, *jobs = sys.argv[1:]
request = urllib.request.Request(
    f"{api}/repos/{repository}/commits/{commit}/check-runs?per_page=100",
    headers={"Accept": "application/vnd.github+json", "User-Agent": "yjsp-deploy", "X-GitHub-Api-Version": "2022-11-28"},
)
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        runs = json.load(response)["check_runs"]
except (OSError, ValueError, KeyError, TypeError) as error:
    print(f"GitHub didn't say how CI went on {commit[:7]} ({error})")
    sys.exit(1)
latest = {}
for run in runs:
    if run.get("name") in jobs and run.get("id", 0) >= latest.get(run["name"], {}).get("id", 0):
        latest[run["name"]] = run
ENDED = {"failure": "failed", "cancelled": "was cancelled", "timed_out": "timed out", "skipped": "was skipped"}
problems = []
for job in jobs:
    run = latest.get(job)
    if run is None:
        problems.append(f"{job} hasn't run")
    elif run.get("status") != "completed":
        problems.append(f"{job} is {'running' if run.get('status') == 'in_progress' else 'waiting'}")
    elif run.get("conclusion") != "success":
        problems.append(f"{job} {ENDED.get(run.get('conclusion'), run.get('conclusion'))}")
if problems:
    print(f"CI hasn't passed on {commit[:7]}: {', '.join(problems)}")
    sys.exit(1)
print(f"CI passed on {commit[:7]}: {', '.join(jobs)}")
PYTHON
    ) || stopped "$said"
    echo "$said"
}

# The web app, built from the commit as yjsp-build: in a folder it owns, which nothing else uses.
build() {
    step build "Building the web app"
    rm -rf "$WORK/build"
    mkdir -p "$WORK/build" "$WORK/npm"
    if [ -n "$BUILDER" ]; then chown "$BUILDER:" "$WORK/build" "$WORK/npm"; fi
    git -C "$WORK/repo.git" archive --format=tar "$COMMIT" web | as_builder tar -x -C "$WORK/build"
    # shellcheck disable=SC2016 # expanded by the builder's bash
    as_builder env PATH="$NODE:$PATH" HOME="$WORK/npm" npm_config_cache="$WORK/npm" bash -c \
        'cd "$1" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent' build "$WORK/build/web" ||
        stopped "The web app didn't build: the log says why"
    # Nothing of the build's left running to change what it made, which is only files and folders: a link could have
    # the site serve something that isn't the web app.
    if [ -n "$BUILDER" ]; then pkill -KILL -u "$BUILDER" 2>/dev/null || true; fi
    [ -f "$WORK/build/web/dist/index.html" ] || stopped "The web app's build has no index.html"
    local odd
    odd=$(find "$WORK/build/web/dist" ! -type f ! -type d -print -quit)
    [ -z "$odd" ] || stopped "The web app's build made something that isn't a file or a folder: $odd"
}

# The server's Python environment for its code in PROJECT, as uv.lock says: sync_venv PROJECT [uv's options].
sync_venv() {
    local project=$1
    shift
    env UV_PYTHON_INSTALL_DIR=/opt/yjsp/python UV_CACHE_DIR=/opt/yjsp/cache UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
        "$UV" sync --quiet --locked --no-dev --no-editable --python 3.13 --project "$project" "$@"
}

# The new version's migrations, on a copy of the database, with its own code in an environment of its own (from the
# cache the site's shares, which then has all the switch-over needs). The copy is made, migrated, and deleted as the
# site's user, whose data it is.
rehearse() {
    step rehearse "Rehearsing the migrations on a copy of the database"
    rm -rf "$WORK/server"
    mkdir -p "$WORK/server"
    git -C "$WORK/repo.git" archive --format=tar "$COMMIT" server | tar -x -C "$WORK/server" --strip-components=1 --no-same-owner
    sync_venv "$WORK/server" || stopped "The server's Python packages didn't install: the log says why"
    local copy=$SRV/backups/.rehearsal.db migrated=0
    as_site rm -f "$copy" "$copy-wal" "$copy-shm"
    as_site sqlite3 "$SRV/data/yjsp.db" ".backup '$copy'"
    as_site "$WORK/server/.venv/bin/python" -I - "$copy" <<'PYTHON' || migrated=$?
import sqlite3, sys, time
from contextlib import closing

from yjsp_server.db import make_engine, migrate

copy = sys.argv[1]


def revision():
    with closing(sqlite3.connect(copy)) as db:
        try:
            row = db.execute("SELECT version_num FROM alembic_version").fetchone()
        except sqlite3.Error:
            return "none"
    return row[0] if row else "none"


def rows():
    with closing(sqlite3.connect(copy)) as db:
        tables = [t for (t,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'") if not t.startswith("sqlite_")]
        return {t: db.execute('SELECT count(*) FROM "%s"' % t.replace('"', '""')).fetchone()[0] for t in tables}


before, counted = revision(), rows()
started = time.monotonic()
engine = make_engine(f"sqlite:///{copy}")
try:
    migrate(engine)
finally:
    engine.dispose()
took = time.monotonic() - started
with closing(sqlite3.connect(copy)) as db:
    verdict = db.execute("PRAGMA integrity_check").fetchone()[0]
if verdict != "ok":
    sys.exit(f"The migrated copy isn't whole: SQLite says {verdict}")
print(f"The copy went from migration {before} to {revision()} in {took:.1f} s, and checks out.")
fewer = [f"{t} ({counted[t]:,} to {n:,})" for t, n in rows().items() if n < counted.get(t, 0)]
if fewer:
    print("Tables with fewer rows after it: " + ", ".join(fewer))
PYTHON
    as_site rm -f "$copy" "$copy-wal" "$copy-shm"
    [ "$migrated" = 0 ] || stopped "Its migrations failed on a copy of the database, so nothing has changed: the log says why"
}

# The new version beside the site's (APP/*.next): its server, its web app, as built, and the help's docs.
stage() {
    cd "$APP"
    rm -rf server.next web.next help.next
    mkdir server.next web.next help.next
    git -C "$WORK/repo.git" archive --format=tar "$COMMIT" server | tar -x -C server.next --strip-components=1 --no-same-owner
    cp -R "$WORK/build/web/dist" web.next/dist
    git -C "$WORK/repo.git" archive --format=tar "$COMMIT" README.md docs client/src/Vault.SolidWorks/README.md |
        tar -x -C help.next --no-same-owner
}

# Whether the server at URL answers within WAIT seconds: healthy URL.
healthy() {
    local tries
    for ((tries = 0; tries < WAIT; tries++)); do
        if curl -fs -o /dev/null "$1/healthz"; then return 0; fi
        sleep 1
    done
    return 1
}

# What's live now, for the Deploy card.
record_live() {
    [ -d "$STATE" ] || return 0
    local deploy=${RECORD:-}
    python3 - "$STATE/live.json" "$COMMIT" "${SUBJECT:-}" "$(now)" "${deploy##*/}" <<'PYTHON'
import json, os, sys

path, commit, subject, at, deploy = sys.argv[1:]
with open(path + ".tmp", "w") as file:
    json.dump({"commit": commit, "subject": subject or None, "deployed_at": at, "deploy": deploy or None}, file, indent=2)
os.chmod(path + ".tmp", 0o640)
os.replace(path + ".tmp", path)
PYTHON
}

# Puts APP/{server,web,help}.STAGED in place of the site's, as one: switch_over STAGED. The database is backed up first,
# and if the new version doesn't answer, the old one goes back.
switch_over() {
    local staged=$1 part
    cd "$APP"
    for part in server/pyproject.toml web/dist/index.html help/README.md; do
        [ -f "${part%%/*}.$staged/${part#*/}" ] || stopped "${part%%/*}.$staged isn't whole, so nothing has changed: deploy again"
    done
    step backup "Backing up the database"
    BACKUP=$SRV/backups/yjsp-before-deploy-$(date -u +%Y%m%d-%H%M%S).db
    as_site sqlite3 "$SRV/data/yjsp.db" ".backup '$BACKUP'"
    as_site gzip "$BACKUP" # kept 14 days, as the nightly backups are
    step switch "Switching over: the site is down until the new version answers"
    TOUCHED=1
    systemctl stop yjsp.service
    rm -rf server.old web.old help.old
    mv server server.old && mv "server.$staged" server && mv server.old/.venv server/.venv # the venv stays where it was
    mv web web.old && mv "web.$staged" web
    if [ -d help ]; then mv help help.old; fi # not before the first deploy with the help
    mv "help.$staged" help
    if sync_venv server --compile-bytecode && systemctl start yjsp.service; then
        step health "Waiting for the new version to answer"
        if healthy "$SITE"; then
            deployed
            return
        fi
    fi
    roll_back
}

deployed() {
    echo "Deployed: YJSP answers."
    record_live
    local page
    page=$(curl -fs "$SITE/help" || true) # read whole: grep -q stopping curl partway would fail the pipe
    if ! grep -q 'id="guide"' <<<"$page"; then
        echo "The help page is empty: set YJSP_HELP_DIR=/opt/yjsp/app/help in /srv/yjsp/.env and restart (docs/deploying.md)." >&2
    fi
    # The demo, once it's set up (docs/deploying.md, "The demo"): made again from nothing by the new version. It's
    # beside the site, not part of it, so a demo that doesn't start is said, and the site stays deployed.
    if systemctl cat yjsp-demo.service >/dev/null 2>&1; then
        step demo "Making the demo again"
        if systemctl restart yjsp-demo.service && curl -fs -o /dev/null --retry 30 --retry-all-errors --retry-delay 1 "$DEMO/healthz"; then
            echo "The demo is made again, and answers."
        else
            echo "The demo didn't start: journalctl -u yjsp-demo says why. The site itself is deployed." >&2
            journalctl -u yjsp-demo.service --no-pager -n 20 -o cat >&2 || true
        fi
    fi
    finish deployed "${COMMIT:0:7} is live"
}

roll_back() {
    step rollback "The new version doesn't answer: putting the old one back"
    journalctl -u yjsp.service --no-pager -n 20 -o cat >&2 || true
    systemctl stop yjsp.service || true
    cd "$APP"
    mv server/.venv server.old/.venv && rm -rf server && mv server.old server
    rm -rf web && mv web.old web
    rm -rf help && if [ -d help.old ]; then mv help.old help; fi
    if sync_venv server --compile-bytecode && systemctl start yjsp.service && healthy "$SITE"; then
        echo "The old version is back." >&2
        finish rolled-back "The new version didn't answer, so the old one is back: the log says why"
    else
        finish failed "The new version didn't answer, and the old one doesn't either: the site is down. If the new version migrated the database, put back $BACKUP.gz (docs/deploying.md, \"Rolling back\")"
    fi
    exit 1
}

# What yjsp-deploy.service runs: main, from GitHub.
deploy_main() {
    if [ ! -d "$STATE" ]; then
        echo "$STATE isn't there: docs/deploying.md, \"Deploying from the site\", sets it up." >&2
        exit 1
    fi
    begin site
    take_lock
    BUILDING=1
    preflight
    fetch
    check_ci
    build
    rehearse
    stage
    switch_over next
}

# What deploy.sh has the server run, once it has copied a version beside the site's: switch-over COMMIT [SUBJECT].
switch_over_for_laptop() {
    COMMIT=${1:?usage: yjsp-deploy switch-over COMMIT [SUBJECT]}
    SUBJECT=${2:-}
    if [ -d "$STATE" ]; then
        begin laptop
        record commit "$COMMIT" subject "$SUBJECT"
    fi
    take_lock
    switch_over new
}

main() {
    trap on_exit EXIT
    case "${1:-}" in
    "") deploy_main ;;
    switch-over)
        shift
        switch_over_for_laptop "$@"
        ;;
    *)
        echo "usage: yjsp-deploy [switch-over COMMIT [SUBJECT]]" >&2
        exit 2
        ;;
    esac
}

# Last, so that all of it is read before any of it runs: deploy.sh pipes this to the server's bash.
main "$@"
