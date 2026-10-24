#!/usr/bin/env bash
# Deploy YJSP (the server, with Vault and Yorg, and the web app) to the Oracle server. How the site is hosted, what
# this does, and what to check afterwards: docs/deploying.md.
#
#   bash deploy/deploy.sh            # main, as it is on GitHub now
#   bash deploy/deploy.sh v0.2.0     # a release tag (or any commit on main)
#
# It builds the web app from exactly that commit, in a checkout of its own next to this repository (so what you have
# open here doesn't matter), ships server/, web/dist, and the docs the help shows, backs up the database, switches over,
# and puts the old version back if the new one doesn't answer.
#
# Needs bash (Git Bash on Windows), git, Node.js 24 with npm, and SSH access to the server. Settings:
#   YJSP_DEPLOY_HOST=opc@lucazerega.tail07089c.ts.net
#                                         the server, over Tailscale (docs/deploying.md, "Getting access")
#   YJSP_DEPLOY_KEY=~/.ssh/yjsp_oracle    your SSH key for it
#   YJSP_DEPLOY_DRY_RUN=1                 build it, then stop before touching the server
#   YJSP_DEPLOY_UNMERGED=1                allow a commit that isn't on main (only when the repository's owner asks)
set -euo pipefail

host=${YJSP_DEPLOY_HOST:-opc@lucazerega.tail07089c.ts.net}
key=${YJSP_DEPLOY_KEY:-$HOME/.ssh/yjsp_oracle}
repo=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
work="$(dirname "$repo")/.yjsp-deploy" # a short path: Windows can't hold node_modules under a long one
run() { ssh -i "$key" -o BatchMode=yes "$host" "$@"; }

command -v npm >/dev/null || {
    echo 'npm is not on PATH. Install Node.js 24 (on Windows, in Git Bash: export PATH="/c/Program Files/nodejs:$PATH").' >&2
    exit 1
}
if [ -z "${YJSP_DEPLOY_DRY_RUN:-}" ]; then
    if [ ! -f "$key" ]; then
        echo "No SSH key at $key: docs/deploying.md says how to get access to the server." >&2
        exit 1
    fi
    # A server still laid out as it was before YJSP (/srv/vault) is moved over once, by migrate-to-yjsp.sh.
    if ! run true; then
        echo "Can't reach the server as $host. It's reached through Tailscale: is this computer on the owner's tailnet," >&2
        echo "with its key on the server? (docs/deploying.md, \"Getting access\")" >&2
        exit 1
    fi
    if ! run 'test -d /opt/yjsp/app/server/.venv && systemctl cat yjsp.service >/dev/null 2>&1'; then
        echo "The server isn't set up for YJSP yet: run deploy/migrate-to-yjsp.sh once (docs/deploying.md)." >&2
        exit 1
    fi
fi

# What to deploy: the server only ever runs code that's on GitHub, and on main unless the owner says otherwise.
git -C "$repo" fetch --quiet --tags origin
wanted=${1:-origin/main}
commit=$(git -C "$repo" rev-parse --verify --quiet "$wanted^{commit}") || {
    echo "There's no commit called $wanted." >&2
    exit 1
}
if [ -z "$(git -C "$repo" branch --remotes --contains "$commit")" ]; then
    echo "$wanted isn't on GitHub: push it first." >&2
    exit 1
fi
if ! git -C "$repo" merge-base --is-ancestor "$commit" origin/main && [ -z "${YJSP_DEPLOY_UNMERGED:-}" ]; then
    echo "$wanted isn't on main. Deploy main or a release tag; see docs/deploying.md." >&2
    exit 1
fi

# A checkout of exactly that commit, gone again when this ends.
cleanup() {
    git -C "$repo" worktree remove --force "$work" 2>/dev/null || rm -rf "$work"
    git -C "$repo" worktree prune
}
cleanup
trap cleanup EXIT
git -C "$repo" worktree add --quiet --detach "$work" "$commit"
if [ ! -f "$work/web/package.json" ] || [ ! -f "$work/server/uv.lock" ]; then
    echo "$wanted is older than the web app and this way of deploying it: deploy a newer commit." >&2
    exit 1
fi
echo "Deploying $(git -C "$work" log --oneline -1) to $host"

echo "Building the web app..."
(cd "$work/web" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent)

if [ -n "${YJSP_DEPLOY_DRY_RUN:-}" ]; then
    echo "Dry run: the build is ready, and the server wasn't touched."
    exit 0
fi

git -C "$work" archive --format=tar HEAD server | run 'sudo rm -rf /opt/yjsp/app/server.new && sudo mkdir -p /opt/yjsp/app/server.new && sudo tar -C /opt/yjsp/app/server.new --strip-components=1 --no-same-owner -xf -'
tar -C "$work/web" -cf - dist | run 'sudo rm -rf /opt/yjsp/app/web.new && sudo mkdir -p /opt/yjsp/app/web.new && sudo tar -C /opt/yjsp/app/web.new --no-same-owner -xf -'
# The help (/help, and what the assistant reads), laid out as in the repository: YJSP_HELP_DIR=/opt/yjsp/app/help.
git -C "$work" archive --format=tar HEAD README.md docs client/src/Vault.SolidWorks/README.md | run 'sudo rm -rf /opt/yjsp/app/help.new && sudo mkdir -p /opt/yjsp/app/help.new && sudo tar -C /opt/yjsp/app/help.new --no-same-owner -xf -'

run 'sudo bash -s' <<'EOF'
set -euo pipefail
cd /opt/yjsp/app
healthy() {
    for _ in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:8100/healthz && return 0; sleep 1; done
    return 1
}
sync() {
    env UV_PYTHON_INSTALL_DIR=/opt/yjsp/python UV_CACHE_DIR=/opt/yjsp/cache UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy \
        UV_PYTHON_DOWNLOADS=never /usr/local/bin/uv sync --quiet --locked --no-dev --no-editable --python 3.13 --project server
}
backup=/srv/yjsp/backups/yjsp-before-deploy-$(date -u +%Y%m%d-%H%M%S).db
sudo -u yjsp sqlite3 /srv/yjsp/data/yjsp.db ".backup '$backup'" && sudo -u yjsp gzip "$backup" # kept 14 days
systemctl stop yjsp.service
rm -rf server.old web.old help.old
mv server server.old && mv server.new server && mv server.old/.venv server/.venv # the venv stays where it was
mv web web.old && mv web.new web
if [ -d help ]; then mv help help.old; fi # not before the first deploy with the help
mv help.new help
sync
systemctl start yjsp.service
if healthy; then
    echo "Deployed: YJSP answers."
    if ! curl -fs http://127.0.0.1:8100/help | grep -q 'id="guide"'; then
        echo "The help page is empty: set YJSP_HELP_DIR=/opt/yjsp/app/help in /srv/yjsp/.env and restart (docs/deploying.md)." >&2
    fi
else
    echo "The new version doesn't answer: putting the old one back." >&2
    journalctl -u yjsp.service --no-pager -n 20 -o cat >&2
    systemctl stop yjsp.service
    mv server/.venv server.old/.venv && rm -rf server && mv server.old server
    rm -rf web && mv web.old web
    rm -rf help && if [ -d help.old ]; then mv help.old help; fi
    sync
    systemctl start yjsp.service
    healthy && echo "The old version is back." >&2
    exit 1
fi
EOF
echo "Now check the site: docs/deploying.md, \"After deploying\"."
