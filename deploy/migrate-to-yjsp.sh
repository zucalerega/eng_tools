#!/usr/bin/env bash
# Move the live server from its layout before YJSP (/srv/vault, /opt/vault, the vault user, vault.service, vault.db,
# CVC_* settings) to YJSP's (/srv/yjsp, /opt/yjsp, yjsp, yjsp.service, yjsp.db, YJSP_* settings), and deploy a
# release there. Run it once, in place of deploy.sh, for the first YJSP release (0.4.0); deploy.sh does every release
# after it, and this script goes in the release after that. docs/deploying.md, "Moving to YJSP", says when and how.
#
#   bash deploy/migrate-to-yjsp.sh v0.4.0                  # move, and deploy that release
#   YJSP_DEPLOY_DRY_RUN=1 bash deploy/migrate-to-yjsp.sh   # build, and check the server's as expected: no changes
#   bash deploy/migrate-to-yjsp.sh --back                  # undo it: the old layout, running the old version
#
# Settings as deploy.sh's: YJSP_DEPLOY_HOST, YJSP_DEPLOY_KEY, YJSP_DEPLOY_DRY_RUN, YJSP_DEPLOY_UNMERGED.
#
# The site stays up while the new version is built and installed beside the old one; it's down for about half a
# minute while the switch happens. If the new version doesn't answer, everything is put back as it was. /opt/vault
# (the old version) and backups/before-yjsp (its settings and services) are kept, for --back: delete them once the
# site has run well for a week.
set -euo pipefail

host=${YJSP_DEPLOY_HOST:-opc@lucazerega.tail07089c.ts.net}
key=${YJSP_DEPLOY_KEY:-$HOME/.ssh/yjsp_oracle}
repo=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
work="$(dirname "$repo")/.yjsp-deploy" # a short path: Windows can't hold node_modules under a long one
run() { ssh -i "$key" -o BatchMode=yes "$host" "$@"; }

# On the server, as root: check (read-only), prepare (beside the running site), switch, or back.
remote() {
    run "sudo bash -s -- $1" <<'EOF'
set -euo pipefail
mode=$1
old_srv=/srv/vault old_opt=/opt/vault new_srv=/srv/yjsp new_opt=/opt/yjsp
units=(yjsp.service yjsp-backup.service yjsp-backup.timer)
old_units=(vault.service vault-backup.service vault-backup.timer)
saved=$new_srv/backups/before-yjsp # after the move; $old_srv/backups/before-yjsp before it

healthy() {
    for _ in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:8100/healthz && return 0; sleep 1; done
    return 1
}

check() {
    local problems=()
    for path in $old_srv/.env $old_srv/data/vault.db $old_srv/data/blobs $old_srv/data/yorg $old_opt/app/server; do
        [ -e "$path" ] || problems+=("$path is missing")
    done
    [ ! -e $new_srv ] || problems+=("$new_srv is there already")
    systemctl cat vault.service >/dev/null 2>&1 || problems+=("vault.service is missing")
    ! systemctl cat yjsp.service >/dev/null 2>&1 || problems+=("yjsp.service is there already")
    id vault >/dev/null 2>&1 || problems+=("the vault user is missing")
    ! id yjsp >/dev/null 2>&1 || problems+=("a yjsp user is there already")
    # Only the layout docs/deploying.md describes is moved; anything else, by hand. (The .env is never printed.)
    for line in CVC_DATABASE_URL=sqlite:///$old_srv/data/vault.db CVC_BLOB_DIR=$old_srv/data/blobs \
        CVC_YORG_DIR=$old_srv/data/yorg; do
        grep -qx "$line" $old_srv/.env 2>/dev/null || problems+=("$old_srv/.env doesn't say $line")
    done
    if [ ${#problems[@]} -gt 0 ]; then
        printf 'The server is not as this script expects, so nothing was changed:\n' >&2
        printf '  %s\n' "${problems[@]}" >&2
        exit 1
    fi
    echo "The server is as expected: $old_srv, $old_opt, vault.service, and the vault user."
}

# The new version beside the old one, which keeps running: its own Python, code, and environment in /opt/yjsp.
prepare() {
    env UV_PYTHON_INSTALL_DIR=$new_opt/python /usr/local/bin/uv python install --quiet 3.13
    env UV_PYTHON_INSTALL_DIR=$new_opt/python UV_CACHE_DIR=$new_opt/cache UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy \
        UV_PYTHON_DOWNLOADS=never /usr/local/bin/uv sync --quiet --locked --no-dev --no-editable --python 3.13 \
        --project $new_opt/app/server
}

# The settings, renamed: CVC_X is YJSP_X, CVC_BLOB_DIR is YJSP_VAULT_DIR (the folder blobs/ is in), and paths move.
rename_settings() {
    local env=$new_srv/.env tmp
    tmp=$(mktemp $new_srv/.env.XXXXXX)
    sed -E \
        -e "s#^(export +)?CVC_BLOB_DIR=$old_srv/data/blobs\$#\\1YJSP_VAULT_DIR=$new_srv/data/vault#" \
        -e "s#^(export +)?CVC_DATABASE_URL=sqlite:///$old_srv/data/vault\\.db\$#\\1YJSP_DATABASE_URL=sqlite:///$new_srv/data/yjsp.db#" \
        -e 's#^(export +)?CVC_#\1YJSP_#' \
        -e "s#=$old_srv/#=$new_srv/#" -e "s#=$old_opt/#=$new_opt/#" \
        $env >"$tmp"
    if grep -qE '^(export +)?CVC_' "$tmp" || grep -qE "=($old_srv|$old_opt)/" "$tmp" ||
        ! grep -qx "YJSP_VAULT_DIR=$new_srv/data/vault" "$tmp" ||
        ! grep -qx "YJSP_DATABASE_URL=sqlite:///$new_srv/data/yjsp.db" "$tmp"; then
        rm -f "$tmp"
        echo "Renaming the settings in $env didn't come out as expected." >&2
        return 1
    fi
    chown yjsp:yjsp "$tmp" && chmod 600 "$tmp" && mv "$tmp" $env
}

switch() {
    # Whatever fails from here on, everything goes back as it was (back), and the old version runs again.
    trap 'echo "Switching failed: putting everything back." >&2; set +e; back' EXIT
    systemctl stop vault-backup.timer vault-backup.service vault.service
    local backup
    backup=$old_srv/backups/vault-before-migration-$(date -u +%Y%m%d-%H%M%S).db
    sudo -u vault sqlite3 $old_srv/data/vault.db "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
    sudo -u vault sqlite3 $old_srv/data/vault.db ".backup '$backup'"
    sudo -u vault gzip "$backup"
    # What going back needs: the settings and the services as they are now. Only root and the server read them.
    mkdir -p $old_srv/backups/before-yjsp
    cp -p $old_srv/.env $old_srv/backups/before-yjsp/env
    for unit in "${old_units[@]}"; do cp -p /etc/systemd/system/$unit $old_srv/backups/before-yjsp/; done
    cp -p /usr/local/sbin/vault-backup $old_srv/backups/before-yjsp/
    chown -R vault:vault $old_srv/backups/before-yjsp && chmod 700 $old_srv/backups/before-yjsp

    usermod -l yjsp vault && groupmod -n yjsp vault
    mv $old_srv $new_srv
    [ "$(getent passwd yjsp | cut -d: -f6)" != $old_srv ] || usermod -d $new_srv yjsp
    cd $new_srv/data
    for end in "" -wal -shm; do if [ -e vault.db$end ]; then mv vault.db$end yjsp.db$end; fi; done
    install -d -o yjsp -g yjsp vault && mv blobs vault/blobs
    cd $new_srv/backups
    for file in vault-*.db.gz; do if [ -e "$file" ]; then mv "$file" "yjsp-${file#vault-}"; fi; done
    rename_settings

    for unit in "${units[@]}"; do install -m 644 $new_opt/app/deploy/$unit /etc/systemd/system/$unit; done
    install -m 755 $new_opt/app/deploy/yjsp-backup /usr/local/sbin/yjsp-backup
    systemctl daemon-reload
    systemctl start yjsp.service
    if ! healthy; then
        echo "The new version doesn't answer:" >&2
        journalctl -u yjsp.service --no-pager -n 20 -o cat >&2
        exit 1 # and back, from the trap
    fi
    trap - EXIT
    systemctl enable --quiet yjsp.service yjsp-backup.timer && systemctl start yjsp-backup.timer
    systemctl disable --quiet vault.service vault-backup.timer
    for unit in "${old_units[@]}"; do rm -f /etc/systemd/system/$unit; done
    rm -f /usr/local/sbin/vault-backup
    rm -rf $new_opt/app/deploy # the services' files, installed now
    systemctl daemon-reload
    echo "Moved: YJSP answers."
}

# Undo switch, from wherever it got to (each step checks what's there first), or later, with --back.
back() {
    systemctl stop yjsp.service yjsp-backup.timer 2>/dev/null || true
    systemctl disable --quiet yjsp.service yjsp-backup.timer 2>/dev/null || true
    local where=$new_srv
    [ -d $new_srv ] || where=$old_srv
    if [ ! -f $where/backups/before-yjsp/env ]; then
        # Stopped before anything was moved: the old version just starts again.
        systemctl start vault.service vault-backup.timer
        if healthy; then
            echo "Back as it was: the old version answers."
        else
            echo "The old version doesn't answer." >&2
        fi
        return
    fi
    for unit in "${old_units[@]}"; do install -m 644 $where/backups/before-yjsp/$unit /etc/systemd/system/$unit; done
    install -m 755 $where/backups/before-yjsp/vault-backup /usr/local/sbin/vault-backup
    for unit in "${units[@]}"; do rm -f /etc/systemd/system/$unit; done
    rm -f /usr/local/sbin/yjsp-backup
    systemctl daemon-reload

    cd $where/backups
    for file in yjsp-*.db.gz; do if [ -e "$file" ]; then mv "$file" "vault-${file#yjsp-}"; fi; done
    cd $where/data
    for end in "" -wal -shm; do if [ -e yjsp.db$end ]; then mv yjsp.db$end vault.db$end; fi; done
    if [ -d vault/blobs ] && [ ! -e blobs ]; then mv vault/blobs blobs && rmdir vault; fi
    cp -p $where/backups/before-yjsp/env $where/.env
    cd /
    if [ $where = $new_srv ]; then mv $new_srv $old_srv; fi
    if id yjsp >/dev/null 2>&1; then
        usermod -l vault yjsp && groupmod -n vault yjsp
        [ "$(getent passwd vault | cut -d: -f6)" != $new_srv ] || usermod -d $old_srv vault
    fi
    systemctl enable --quiet vault.service vault-backup.timer
    systemctl start vault.service vault-backup.timer
    if healthy; then
        echo "Back as it was: the old version answers."
    else
        echo "The old version doesn't answer either." >&2
    fi
}

case $mode in
check) check ;;
prepare) check && prepare ;;
switch) check && switch ;;
back) back ;;
esac
EOF
}

command -v npm >/dev/null || {
    echo 'npm is not on PATH. Install Node.js 24 (on Windows, in Git Bash: export PATH="/c/Program Files/nodejs:$PATH").' >&2
    exit 1
}
if [ ! -f "$key" ]; then
    echo "No SSH key at $key: docs/deploying.md says how to get access to the server." >&2
    exit 1
fi
if [ "${1:-}" = "--back" ]; then
    remote back
    exit
fi

# What to deploy, as deploy.sh decides it: a commit on GitHub, on main unless the owner says otherwise, and YJSP's.
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
remote check

cleanup() {
    git -C "$repo" worktree remove --force "$work" 2>/dev/null || rm -rf "$work"
    git -C "$repo" worktree prune
}
cleanup
trap cleanup EXIT
git -C "$repo" worktree add --quiet --detach "$work" "$commit"
if [ ! -f "$work/deploy/yjsp.service" ]; then
    echo "$wanted is from before YJSP: move to YJSP with a release that is." >&2
    exit 1
fi
echo "Moving to YJSP with $(git -C "$work" log --oneline -1) on $host"

echo "Building the web app..."
(cd "$work/web" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent)

if [ -n "${YJSP_DEPLOY_DRY_RUN:-}" ]; then
    echo "Dry run: the build is ready, the server is as expected, and nothing on it was changed."
    exit 0
fi

# /opt/yjsp/app holds only what an earlier try left (check made sure /srv/yjsp isn't there), so it starts afresh.
git -C "$work" archive --format=tar HEAD server deploy |
    run 'test ! -e /srv/yjsp && sudo rm -rf /opt/yjsp/app && sudo mkdir -p /opt/yjsp/app &&
        sudo tar -C /opt/yjsp/app --no-same-owner -xf -'
tar -C "$work/web" -cf - dist |
    run 'sudo mkdir -p /opt/yjsp/app/web && sudo tar -C /opt/yjsp/app/web --no-same-owner -xf -'
echo "Installing it beside the running site..."
remote prepare
echo "Switching over: the site is down for about half a minute..."
remote switch
echo "Now check the site: docs/deploying.md, \"After deploying\"."
