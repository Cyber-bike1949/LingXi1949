#!/usr/bin/env bash
# Install the standalone LingXi1949 Agent for Obsidian pairing.
set -euo pipefail

AGENT_VERSION='5.0.1'
RELEASE_REPOSITORY='Cyber-bike1949/LingXi1949'
SERVICE_USER='lingxi1949'
SERVICE_NAME='lingxi1949-agent.service'
MODE='foreground'

usage() {
  cat <<'EOF'
Usage: install-agent.sh [--service [--user NAME]]

Without options, install the Agent for the current user and run it in this terminal.
--service creates a dedicated system user and a persistent systemd service.
--user NAME selects the dedicated system user (default: lingxi1949; only with --service).
EOF
}

while (($#)); do
  case "$1" in
    --service) MODE='service'; shift ;;
    --user)
      [[ $# -ge 2 ]] || { echo '--user requires a value.' >&2; exit 1; }
      SERVICE_USER="$2"
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ "$MODE" == 'service' || "$SERVICE_USER" == 'lingxi1949' ]] || {
  echo '--user can only be used with --service.' >&2
  exit 1
}
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$SERVICE_USER" != 'root' ]] || {
  echo 'The service user name is invalid.' >&2
  exit 1
}

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

asset="lingxi1949-agent-$AGENT_VERSION-linux-x64"
release_url="https://github.com/$RELEASE_REPOSITORY/releases/download/remote-$AGENT_VERSION"

if [[ "$MODE" == 'service' ]]; then
  [[ -d /run/systemd/system ]] || { echo 'The --service mode requires systemd.' >&2; exit 1; }
  for command in getent useradd systemctl id runuser; do
    command -v "$command" >/dev/null || {
      echo "Missing required command for service installation: $command" >&2
      exit 1
    }
  done
  if [[ $(id -u) -ne 0 ]]; then
    [[ -f "${BASH_SOURCE[0]:-}" ]] || {
      echo 'Download this script to a file, then run: sudo bash <file> --service' >&2
      exit 1
    }
    exec sudo bash "${BASH_SOURCE[0]}" --service --user "$SERVICE_USER"
  fi
fi

# Some cloud images mount /tmp with noexec; the version check below must run the downloaded binary.
umask 077
cache_home="${XDG_CACHE_HOME:-$HOME/.cache}"
mkdir -p "$cache_home"
stage="$(mktemp -d "$cache_home/lingxi1949-agent.XXXXXXXX")"
cleanup() { rm -rf -- "$stage"; }
trap cleanup EXIT

echo "Downloading LingXi1949 Agent $AGENT_VERSION..."
curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --retry 2 \
  "$release_url/$asset" -o "$stage/$asset"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --retry 2 \
  "$release_url/$asset.sha256" -o "$stage/$asset.sha256"
expected="$(awk -v name="$asset" '$2 == name { print $1; exit }' "$stage/$asset.sha256")"
[[ "$expected" =~ ^[0-9A-Fa-f]{64}$ ]] || { echo 'Invalid Agent checksum.' >&2; exit 1; }
actual="$(sha256sum "$stage/$asset" | awk '{print $1}')"
[[ "${actual,,}" == "${expected,,}" ]] || { echo 'Agent checksum mismatch.' >&2; exit 1; }

if [[ "$MODE" == 'foreground' ]]; then
  data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  install_dir="$data_home/lingxi1949-agent/$AGENT_VERSION"
  binary="$install_dir/lingxi1949"
  mkdir -p "$install_dir"
  install -m 0755 "$stage/$asset" "$binary"
  "$binary" --version >/dev/null
fi

if [[ "$MODE" == 'foreground' ]]; then
  echo 'Agent installed. Copy the connection code below into Obsidian: Add device.'
  echo 'Keep this terminal open while the Agent is in use. Press Ctrl-C to stop it.'
  exec "$binary" run
fi

install_dir="/usr/local/lib/lingxi1949-agent/$AGENT_VERSION"
binary="$install_dir/lingxi1949"
unit_path="/etc/systemd/system/$SERVICE_NAME"
launcher_path='/usr/local/bin/lingxi1949'

if ! getent passwd "$SERVICE_USER" >/dev/null; then
  useradd --system --create-home --home-dir "/var/lib/$SERVICE_USER" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
service_entry="$(getent passwd "$SERVICE_USER")"
IFS=: read -r _ _ service_uid _ _ service_home _ <<< "$service_entry"
[[ "$service_uid" != '0' ]] || { echo 'Refusing to run the Agent as root.' >&2; exit 1; }
[[ "$service_home" == /* && "$service_home" != '/' ]] || { echo 'The service user has an invalid home directory.' >&2; exit 1; }
service_group="$(id -gn "$SERVICE_USER")"
mkdir -p "$install_dir"
install -o root -g root -m 0755 "$stage/$asset" "$binary"
"$binary" --version >/dev/null
install -d -o "$SERVICE_USER" -g "$service_group" -m 0700 "$service_home"

cat > "$launcher_path" <<EOF
#!/usr/bin/env bash
# Manage the persistent LingXi1949 Agent service.
set -euo pipefail

service_name='$SERVICE_NAME'
service_user='$SERVICE_USER'
service_home='$service_home'
agent_binary='$binary'

if [[ "\$(id -u)" -ne 0 ]]; then
  exec sudo "\$0" "\$@"
fi

case "\${1:-status}" in
  status)
    if ! systemctl is-active --quiet "\$service_name"; then
      echo "Agent service is not running: \$service_name" >&2
      systemctl status "\$service_name" --no-pager --lines=8 || true
      exit 3
    fi
    exec runuser -u "\$service_user" -- env HOME="\$service_home" "\$agent_binary" status
    ;;
  run)
    systemctl restart "\$service_name"
    exec "\$0" status
    ;;
  *)
    exec runuser -u "\$service_user" -- env HOME="\$service_home" "\$agent_binary" "\$@"
    ;;
esac
EOF
chmod 0755 "$launcher_path"

cat > "$unit_path" <<EOF
[Unit]
Description=LingXi1949 Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$service_group
WorkingDirectory=$service_home
Environment=HOME=$service_home
ExecStart=$binary run
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$service_home

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl is-active --quiet "$SERVICE_NAME" || {
  echo "The service did not start. Inspect: journalctl -u $SERVICE_NAME -n 100 --no-pager" >&2
  exit 1
}
echo "Agent service is running as $SERVICE_USER and will start automatically after reboot."
echo 'Show the connection code: lingxi1949 status'
echo 'Restart the persistent Agent service: lingxi1949 run'
