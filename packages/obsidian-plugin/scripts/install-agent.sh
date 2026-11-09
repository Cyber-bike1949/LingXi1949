#!/usr/bin/env bash
# Install and run the standalone LingXi1949 Agent for Obsidian pairing.
set -euo pipefail

AGENT_VERSION='5.0.1'
RELEASE_REPOSITORY='Cyber-bike1949/LingXi1949'

[[ "$(uname -s)" == 'Linux' && "$(uname -m)" == 'x86_64' ]] || {
  echo 'This installer supports Linux x64 only.' >&2
  exit 1
}
for command in curl sha256sum mktemp install; do
  command -v "$command" >/dev/null || {
    echo "Missing required command: $command" >&2
    exit 1
  }
done

data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
install_dir="$data_home/lingxi1949-agent/$AGENT_VERSION"
asset="lingxi1949-agent-$AGENT_VERSION-linux-x64"
release_url="https://github.com/$RELEASE_REPOSITORY/releases/download/remote-$AGENT_VERSION"
binary="$install_dir/lingxi1949"

umask 077
if [[ ! -x "$binary" ]]; then
  stage="$(mktemp -d "${TMPDIR:-/tmp}/lingxi1949-agent.XXXXXXXX")"
  cleanup() { rm -rf -- "$stage"; }
  trap cleanup EXIT

  echo "Downloading LingXi1949 Agent $AGENT_VERSION..."
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --retry 2 \
    "$release_url/$asset" -o "$stage/$asset"
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --retry 2 \
    "$release_url/$asset.sha256" -o "$stage/$asset.sha256"
  expected="$(awk -v name="$asset" '$2 == name { print $1; exit }' "$stage/$asset.sha256")"
  [[ "$expected" =~ ^[0-9A-Fa-f]{64}$ ]] || {
    echo 'Invalid Agent checksum.' >&2
    exit 1
  }
  actual="$(sha256sum "$stage/$asset" | awk '{print $1}')"
  [[ "${actual,,}" == "${expected,,}" ]] || {
    echo 'Agent checksum mismatch.' >&2
    exit 1
  }
  "$stage/$asset" --version >/dev/null
  mkdir -p "$install_dir"
  install -m 0755 "$stage/$asset" "$binary"
fi

echo 'Agent installed. Copy the connection code below into Obsidian: Add device.'
echo 'Keep this terminal open while the Agent is in use. Press Ctrl-C to stop it.'
exec "$binary" run
