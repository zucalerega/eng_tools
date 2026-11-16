#!/usr/bin/env bash
# CI's test of the Docker setup a team runs its own site with (deploy/compose, docs/self-hosting.md), on the image CI
# just built: the site through Caddy, over HTTPS, with the team's names; and backup.sh's copy and check, then its restore
# onto a machine with nothing, which must bring back the same data. Run it from the repository's top folder:
#
#   bash .github/compose-test.sh yjsp-server:ci
#
# It uses ports 80 and 443, and Docker's project `yjsp`, and removes what it made when it's done.
set -euo pipefail
image=${1:?usage: compose-test.sh <image:tag>}
compose_files=$(pwd)/deploy/compose
here=$(mktemp -d)
cp -a "$compose_files/." "$here/"
cd "$here"

cleanup() {
    docker compose --profile backup down -v --remove-orphans >/dev/null 2>&1 || true
    docker volume rm -f yjsp-test-seed >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The example's settings, with the test's after them (the last of a name wins), so the example itself is read too.
cp .env.example .env
cat >>.env <<EOF
YJSP_IMAGE=${image%:*}
YJSP_VERSION=${image##*:}
YJSP_DOMAIN=localhost
YJSP_SECRET_KEY=$(openssl rand -base64 48)
YJSP_GOOGLE_CLIENT_ID=test.apps.googleusercontent.com
YJSP_GOOGLE_CLIENT_SECRET=test
EOF
printf 'RESTIC_REPOSITORY=/repo\nRESTIC_PASSWORD=%s\n' "$(openssl rand -base64 32)" >backup.env
mkdir repo
cat >compose.override.yaml <<'EOF'
# The test's repository: a folder here, not object storage.
services:
  backup:
    volumes:
      - ./repo:/repo
EOF

healthy() {
    for _ in $(seq 90); do
        [ "$(docker inspect -f '{{.State.Health.Status}}' yjsp-server-1 2>/dev/null)" != healthy ] || return 0
        sleep 1
    done
    docker compose logs server
    echo "The server didn't start" >&2
    return 1
}

# Through Caddy, as people reach it, trusting only the certificate authority Caddy made for localhost.
through_caddy() {
    for _ in $(seq 30); do
        docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt root.crt >/dev/null 2>&1 && break
        sleep 1
    done
    curl -sS --fail --noproxy '*' --cacert root.crt --retry 30 --retry-all-errors --retry-delay 1 "https://localhost$1"
}

# What must come back: Vault's and Yorg's files, by their hashes, and who has an account.
fingerprint() {
    docker compose exec -T server sh -c '
        cd /data && find vault yorg -type f -not -path "*/tmp/*" -not -path "yorg/runs/*" -not -path "yorg/matplotlib/*" |
            sort | xargs -r sha256sum
        python -c "import sqlite3; print(sqlite3.connect(\"/data/yjsp.db\").execute(\"select email from users order by email\").fetchall())"'
}

echo "== The site, through Caddy"
docker compose up -d --quiet-pull
healthy
[ "$(through_caddy /healthz)" = '{"ok":true}' ]
page=$(through_caddy /)
grep -q '<title>Sign in · RPL</title>' <<<"$page"
grep -q 'Rocket Propulsion Lab' <<<"$page"
[ "$(curl -sS --noproxy '*' -o /dev/null -w '%{http_code} %{redirect_url}' http://localhost/vault)" = "308 https://localhost/vault" ]

echo "== Data to back up: the demo's, made with the image's own seeder"
docker compose stop server
docker volume create yjsp-test-seed >/dev/null
docker run --rm -v yjsp-test-seed:/data -e YJSP_DEMO=1 -e YJSP_ROOT_PATH=/demo \
    -e YJSP_DATABASE_URL=sqlite:////data/demo/yjsp.db -e YJSP_VAULT_DIR=/data/demo/vault -e YJSP_YORG_DIR=/data/demo/yorg \
    "$image" yjsp-demo seed
docker run --rm -v yjsp-test-seed:/from -v yjsp_data:/to --entrypoint sh "$image" \
    -c 'rm -f /to/yjsp.db /to/yjsp.db-wal /to/yjsp.db-shm && cp -a /from/demo/yjsp.db /from/demo/vault /from/demo/yorg /to/'
docker compose start server
healthy
before=$(fingerprint)
grep -q '[0-9a-f]\{64\}  vault/blobs/' <<<"$before"

echo "== A copy, and its check"
docker compose run --rm backup init
./backup.sh backup
./backup.sh check
docker compose exec -T server python -c '
import json
status = json.load(open("/data/backups/offsite.json"))
assert status["backed_up_at"] and status["verified_at"], status
assert not status["backup_error"] and not status["verify_error"], status'

echo "== Putting it back, on a machine with nothing"
docker compose down -v
./backup.sh restore </dev/null
healthy
[ "$(fingerprint)" = "$before" ]
docker compose exec -T server sh -c '[ -z "$(find /data -not -user yjsp)" ]'
[ "$(through_caddy /healthz)" = '{"ok":true}' ]

echo "The Docker setup works: the site, through Caddy, and its backups' copy, check, and restore."
