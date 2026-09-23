#!/usr/bin/env bash
# Install the pinned Agent for a dedicated ordinary user.
set -euo pipefail
AGENT_VERSION="2.1.0"
RELEASE_REPO="Cyber-bike1949/LingXi1949"
TARGET_USER="monkey"
SEEN_USER=0
STAGE="arguments"
TMP_INSTALL=""
CREATED_USER=0
ACTIVATING=0
HAD_BINARY=0
HAD_UNIT=0
WAS_ACTIVE=0
say() { printf '%s\n' "$*"; }
die() { printf 'Install failed (%s): %s\n' "$STAGE" "$*" >&2; exit 1; }
usage() { printf 'Usage: install-linux.sh [--user NAME] [--help]\nDefault user: monkey. Re-running upgrades the same user and preserves identity.\n'; }
while (($#)); do
  case "$1" in
    --help) usage; exit 0 ;;
    --user) [[ $# -ge 2 && $SEEN_USER -eq 0 ]] || die '--user requires one value and may only occur once'; TARGET_USER="$2"; SEEN_USER=1; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$TARGET_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$TARGET_USER" != root ]] || die 'invalid ordinary username'
STAGE="preflight"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || die 'this release only provides the Linux x86_64 Agent'
[[ -d /run/systemd/system ]] || die 'systemd is required'
for cmd in curl sha256sum getent useradd runuser loginctl systemctl flock install mktemp; do command -v "$cmd" >/dev/null || die "missing required command: $cmd"; done
[[ -r /etc/os-release ]] || die 'cannot identify distribution'
# Read only operating-system metadata, never user-supplied shell configuration.
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in ubuntu:22.04|ubuntu:24.04|debian:12) ;; *) die "distribution not in the release candidate matrix: ${ID:-unknown} ${VERSION_ID:-unknown}" ;; esac
if [[ $(id -u) -ne 0 ]]; then
  [[ -f "${BASH_SOURCE[0]:-}" ]] || die 'download the script to a file and run sudo bash <file> [--user NAME]'
  exec sudo bash "${BASH_SOURCE[0]}" --user "$TARGET_USER"
fi
umask 077
exec 9>"/run/lock/lingxi1949-install-${TARGET_USER}.lock"
flock -n 9 || die 'another installation is running for this user'
STAGE="user"
if ! getent passwd "$TARGET_USER" >/dev/null; then useradd --create-home --shell /bin/bash "$TARGET_USER"; CREATED_USER=1; fi
PASSWD_ENTRY="$(getent passwd "$TARGET_USER")"
IFS=: read -r _ _ TARGET_UID _ _ TARGET_HOME TARGET_SHELL <<< "$PASSWD_ENTRY"
[[ "$TARGET_UID" -ne 0 && "$TARGET_UID" -ge 1000 ]] || die 'refusing a root or system account'
[[ "$TARGET_HOME" == /* && "$TARGET_HOME" != / && -d "$TARGET_HOME" && ! -L "$TARGET_HOME" ]] || die 'home must be an existing non-symlink absolute directory'
[[ "$(stat -c %u "$TARGET_HOME")" == "$TARGET_UID" ]] || die 'home ownership does not match the target user'
[[ "$TARGET_SHELL" != */nologin && "$TARGET_SHELL" != */false ]] || die 'target account has no usable shell'
BIN_DIR="${TARGET_HOME}/.local/bin"
UNIT_DIR="${TARGET_HOME}/.config/systemd/user"
UNIT_NAME="lingxi1949.service"
TMP_INSTALL="$(mktemp -d)"
as_user() { runuser -u "$TARGET_USER" -- env HOME="$TARGET_HOME" XDG_RUNTIME_DIR="/run/user/${TARGET_UID}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${TARGET_UID}/bus" "$@"; }
cleanup() {
  result=$?
  if (( result != 0 )); then
    printf 'Failed at stage: %s\n' "$STAGE" >&2
    if (( ACTIVATING )); then
      as_user systemctl --user stop "$UNIT_NAME" 2>/dev/null || true
      if (( HAD_BINARY )); then install -o "$TARGET_UID" -m 0755 "$TMP_INSTALL/previous-binary" "$BIN_DIR/lingxi1949"; else rm -f "$BIN_DIR/lingxi1949"; fi
      if (( HAD_UNIT )); then install -o "$TARGET_UID" -m 0644 "$TMP_INSTALL/previous-unit" "$UNIT_DIR/$UNIT_NAME"; else rm -f "$UNIT_DIR/$UNIT_NAME"; fi
      as_user systemctl --user daemon-reload || true
      if (( WAS_ACTIVE )); then as_user systemctl --user start "$UNIT_NAME" || true; fi
    fi
    (( CREATED_USER == 0 )) || printf 'Created account %s remains. Retry with --user %s; do not delete its home without checking its contents.\n' "$TARGET_USER" "$TARGET_USER" >&2
    printf 'Retry the same installer. Inspect: sudo -u %s XDG_RUNTIME_DIR=/run/user/%s systemctl --user status %s\n' "$TARGET_USER" "$TARGET_UID" "$UNIT_NAME" >&2
  fi
  [[ -z "$TMP_INSTALL" ]] || rm -rf -- "$TMP_INSTALL"
}
trap cleanup EXIT
STAGE="download"
BASE="https://github.com/${RELEASE_REPO}/releases/download/${AGENT_VERSION}"
ASSET="lingxi1949-linux-x64"
curl --proto '=https' --tlsv1.2 -fsSL --retry 2 "$BASE/$ASSET" -o "$TMP_INSTALL/$ASSET"
curl --proto '=https' --tlsv1.2 -fsSL --retry 2 "$BASE/$ASSET.sha256" -o "$TMP_INSTALL/checksum"
EXPECTED="$(awk 'NR==1 {print $1}' "$TMP_INSTALL/checksum")"
[[ "$EXPECTED" =~ ^[0-9a-fA-F]{64}$ ]] || die 'invalid checksum file'
ACTUAL="$(sha256sum "$TMP_INSTALL/$ASSET")"
[[ "${ACTUAL%% *}" == "${EXPECTED,,}" ]] || die 'binary checksum mismatch'
STAGE="stage"
# Resolve directories as the target user; root must not follow user-controlled symlinks for writes.
as_user mkdir -p "$BIN_DIR" "$UNIT_DIR"
for target in "$TARGET_HOME/.local" "$BIN_DIR" "$TARGET_HOME/.config" "$TARGET_HOME/.config/systemd" "$UNIT_DIR"; do [[ ! -L "$target" ]] || die 'installation directories must not be symlinks'; done
as_user test -w "$BIN_DIR" || die 'binary directory is not writable'
# Give only the verified asset to the target account before activation.
chmod 0755 "$TMP_INSTALL"
chmod 0644 "$TMP_INSTALL/$ASSET"
as_user install -m 0755 "$TMP_INSTALL/$ASSET" "$BIN_DIR/.lingxi1949-next"
as_user "$BIN_DIR/.lingxi1949-next" --version >/dev/null
STAGE="user-manager"
loginctl enable-linger "$TARGET_USER"
systemctl start "user@${TARGET_UID}.service"
[[ -S "/run/user/${TARGET_UID}/bus" ]] || die 'systemd user bus unavailable'
[[ ! -f "$BIN_DIR/lingxi1949" ]] || { cp "$BIN_DIR/lingxi1949" "$TMP_INSTALL/previous-binary"; HAD_BINARY=1; }
[[ ! -f "$UNIT_DIR/$UNIT_NAME" ]] || { cp "$UNIT_DIR/$UNIT_NAME" "$TMP_INSTALL/previous-unit"; HAD_UNIT=1; }
as_user systemctl --user is-active --quiet "$UNIT_NAME" && WAS_ACTIVE=1 || true
STAGE="activate"
ACTIVATING=1
as_user systemctl --user stop "$UNIT_NAME" 2>/dev/null || true
as_user systemctl --user disable --now termesh-agent.service 2>/dev/null || true
as_user mv -f "$BIN_DIR/.lingxi1949-next" "$BIN_DIR/lingxi1949"
cat > "$TMP_INSTALL/unit" <<'UNIT'
[Unit]
Description=LingXi1949 remote agent
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=%h/.local/bin/lingxi1949 run
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
[Install]
WantedBy=default.target
UNIT
chmod 0644 "$TMP_INSTALL/unit"
as_user install -m 0644 "$TMP_INSTALL/unit" "$UNIT_DIR/$UNIT_NAME"
as_user systemctl --user daemon-reload
as_user systemctl --user enable --now "$UNIT_NAME"
STAGE="verify"
sleep 2
as_user systemctl --user is-active --quiet "$UNIT_NAME" || die 'service did not remain active'
PID="$(as_user systemctl --user show "$UNIT_NAME" --property MainPID --value)"
[[ "$PID" =~ ^[1-9][0-9]*$ && "$(stat -c %u "/proc/$PID")" == "$TARGET_UID" ]] || die 'service identity verification failed'
ACTIVATING=0
say "Agent installed for $TARGET_USER at $BIN_DIR/lingxi1949. Service: $UNIT_NAME"
as_user "$BIN_DIR/lingxi1949" status || say 'Service started; network connection is not ready. Run lingxi1949 status as the target user later.'
