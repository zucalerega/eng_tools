#!/usr/bin/env bash
# Installs what the full check needs and a Claude Code cloud session lacks: the
# .NET 10 SDK (not in the image at all) and Node 24 (the image has 20 to 22, and the
# web tests need 24). Python and uv are already there. Runs from the SessionStart hook
# in .claude/settings.json, at every start and resume, so it skips whatever a
# previous run installed. On a laptop it does nothing.
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

tools="$HOME/.yjsp-tools"
mkdir -p "$tools"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) node_platform=linux-x64 ;;
  Linux-aarch64) node_platform=linux-arm64 ;;
  *) echo "cloud-setup: no Node build for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

failed=()

# Each install builds in a temporary folder and moves it into place only once it's
# complete, so a failed or interrupted install is retried at the next start. Every
# step ends in `|| return 1` because bash ignores `set -e` in a function that is
# called as an `if` condition.

# Node 24, the newest release, checked against the release's published SHA-256.
install_node() {
  local work base file
  work="$(mktemp -d)" || return 1
  base=https://nodejs.org/dist/latest-v24.x
  curl -fsSL "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt" || return 1
  file="$(grep -oE "node-v24\.[0-9]+\.[0-9]+-$node_platform\.tar\.xz" "$work/SHASUMS256.txt" | head -n1)"
  [ -n "$file" ] || return 1
  curl -fsSL "$base/$file" -o "$work/$file" || return 1
  (cd "$work" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || return 1
  mkdir -p "$work/node24" || return 1
  tar -xJf "$work/$file" -C "$work/node24" --strip-components=1 || return 1
  rm -rf "$tools/node24" && mv "$work/node24" "$tools/node24" || return 1
  rm -rf "$work"
}

# The .NET 10 SDK, through Microsoft's install script.
install_dotnet() {
  local work
  work="$(mktemp -d)" || return 1
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o "$work/dotnet-install.sh" || return 1
  bash "$work/dotnet-install.sh" --channel 10.0 --install-dir "$work/dotnet" --no-path >/dev/null || return 1
  rm -rf "$tools/dotnet" && mv "$work/dotnet" "$tools/dotnet" || return 1
  rm -rf "$work"
}

if [ ! -x "$tools/node24/bin/node" ]; then
  if install_node; then
    echo "cloud-setup: installed Node $("$tools/node24/bin/node" --version)"
  else
    failed+=("Node 24 (needs nodejs.org)")
  fi
fi

if [ ! -x "$tools/dotnet/dotnet" ]; then
  if install_dotnet; then
    echo "cloud-setup: installed .NET SDK $("$tools/dotnet/dotnet" --version)"
  else
    failed+=(".NET 10 SDK (needs dot.net and builds.dotnet.microsoft.com)")
  fi
fi

# Later Bash commands in the session run this file first.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export PATH=\"$tools/node24/bin:$tools/dotnet:\$PATH\""
    echo "export DOTNET_ROOT=\"$tools/dotnet\""
    echo "export DOTNET_CLI_TELEMETRY_OPTOUT=1"
    echo "export DOTNET_NOLOGO=1"
  } >>"$CLAUDE_ENV_FILE"
fi

# What this prints reaches Claude, so a failed install, or a test that fails only
# here, is explained rather than showing up later as a confusing check failure.
if [ "$(id -u)" = 0 ]; then
  echo "cloud-setup: this session runs as root, which can write read-only files, so the" \
    "client tests that make a file impossible to replace (4 in WorkspaceTests) fail here." \
    "They pass as a normal user, as in CI."
fi
if [ ${#failed[@]} -gt 0 ]; then
  printf 'cloud-setup: could not install %s.\n' "${failed[@]}"
  echo "cloud-setup: the checks that need it won't run. If the download was blocked, add the" \
    "hosts above to the cloud environment's allowed domains (network access: Custom)."
fi
