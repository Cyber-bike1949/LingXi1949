#!/usr/bin/env bash
#
# Installs lingxi1949 as a user service on Ubuntu (doc 7.4).
#
# One-liner remote install (downloads the latest release, no local checkout
# needed):
#
#   curl -fsSL https://raw.githubusercontent.com/Cyber-bike1949/LingXi1949/main/agent/packaging/install-linux.sh | bash
#
# Or, from a local checkout/build, pass the binary path explicitly:
#
#   ./agent/packaging/install-linux.sh /path/to/lingxi1949
#
# Everything except one step runs unprivileged. `loginctl enable-linger` needs
# root or a polkit prompt on most distributions - that is the documented
# one-off exception in doc 7.4: install with sudo once, run as an ordinary user
# forever after. Without lingering the agent is killed when the SSH session
# ends, which is exactly what MVP completion item 2 forbids.

set -euo pipefail

BIN_DIR="${HOME}/.local/bin"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_NAME="lingxi1949.service"
# v1.9 R-01: the pre-rename unit name, retired below before the new one is
# installed so the two never run at once fighting over the same identity file.
OLD_UNIT_NAME="termesh-agent.service"
RELEASE_REPO="Cyber-bike1949/LingXi1949"
RELEASE_ASSET="lingxi1949-linux-x64"
# Only set when this script is run from a real file (a local checkout), not
# piped through `curl | bash`, where BASH_SOURCE[0] is empty - falling back to
# the current directory there would risk matching an unrelated binary that
# happens to sit at a candidate path below.
SOURCE_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
fi

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

[[ "$(id -u)" -ne 0 ]] || die "run this as the ordinary user that will own the agent, not as root"

TMP_DOWNLOAD_DIR=""
cleanup() { [[ -z "${TMP_DOWNLOAD_DIR}" ]] || rm -rf "${TMP_DOWNLOAD_DIR}"; }
trap cleanup EXIT

BINARY="${1:-}"
if [[ -z "${BINARY}" && -n "${SOURCE_DIR}" ]]; then
  for candidate in \
    "${SOURCE_DIR}/../target/release/lingxi1949" \
    "${SOURCE_DIR}/../target/debug/lingxi1949" \
    "${SOURCE_DIR}/lingxi1949"; do
    [[ -x "${candidate}" ]] && BINARY="${candidate}" && break
  done
fi

if [[ -z "${BINARY}" ]]; then
  command -v curl >/dev/null || die "no local lingxi1949 binary found and curl is not installed to fetch one; pass a binary path as the first argument"
  ARCH="$(uname -m)"
  [[ "${ARCH}" == "x86_64" ]] || die "no prebuilt agent for architecture '${ARCH}' (only x86_64 Linux builds are published); pass a local binary path as the first argument"

  say "no local binary found; downloading the latest release from GitHub"
  TMP_DOWNLOAD_DIR="$(mktemp -d)"
  RELEASE_BASE="https://github.com/${RELEASE_REPO}/releases/latest/download"
  curl -fsSL "${RELEASE_BASE}/${RELEASE_ASSET}" -o "${TMP_DOWNLOAD_DIR}/${RELEASE_ASSET}" \
    || die "download failed: ${RELEASE_BASE}/${RELEASE_ASSET}"
  curl -fsSL "${RELEASE_BASE}/${RELEASE_ASSET}.sha256" -o "${TMP_DOWNLOAD_DIR}/${RELEASE_ASSET}.sha256" \
    || die "download failed: ${RELEASE_BASE}/${RELEASE_ASSET}.sha256"
  (cd "${TMP_DOWNLOAD_DIR}" && sha256sum -c "${RELEASE_ASSET}.sha256") \
    || die "checksum verification failed for the downloaded binary"
  chmod +x "${TMP_DOWNLOAD_DIR}/${RELEASE_ASSET}"
  BINARY="${TMP_DOWNLOAD_DIR}/${RELEASE_ASSET}"
fi
[[ -n "${BINARY}" && -x "${BINARY}" ]] || die "pass the path to the lingxi1949 binary as the first argument"

say "installing the binary into ${BIN_DIR}"
mkdir -p "${BIN_DIR}"
install -m 0755 "${BINARY}" "${BIN_DIR}/lingxi1949"
# v1.9 R-01: leftover pre-rename binary would otherwise keep shadowing PATH
# lookups or confuse `command -v` in older shell hints; safe to remove now
# that the new binary is in place.
rm -f "${BIN_DIR}/termesh-agent"

say "installing the user unit into ${UNIT_DIR}"
mkdir -p "${UNIT_DIR}"
if [[ -n "${SOURCE_DIR}" && -f "${SOURCE_DIR}/${UNIT_NAME}" ]]; then
  install -m 0644 "${SOURCE_DIR}/${UNIT_NAME}" "${UNIT_DIR}/${UNIT_NAME}"
else
  # curl | bash has no checkout to read the unit file from - embed it so the
  # installer stays a single self-contained script.
  UNIT_TMP="$(mktemp)"
  trap 'rm -f "${UNIT_TMP}"; cleanup' EXIT
  cat > "${UNIT_TMP}" <<'UNIT'
[Unit]
Description=LingXi1949 remote agent
Documentation=https://github.com/Cyber-bike1949/LingXi1949
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/.local/bin/lingxi1949 run
Restart=always
RestartSec=5
Environment=RUST_LOG=lingxi1949=info
NoNewPrivileges=true
StandardOutput=journal
StandardError=journal
SyslogIdentifier=lingxi1949

[Install]
WantedBy=default.target
UNIT
  install -m 0644 "${UNIT_TMP}" "${UNIT_DIR}/${UNIT_NAME}"
fi

say "enabling lingering so the agent survives logout"
if loginctl show-user "$(id -un)" --property=Linger 2>/dev/null | grep -q 'Linger=yes'; then
  echo "    already enabled"
else
  echo "    this is the one step that needs elevation (doc 7.4)"
  sudo loginctl enable-linger "$(id -un)"
fi

USER_ID="$(id -u)"
export XDG_RUNTIME_DIR="/run/user/${USER_ID}"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
if [[ ! -S "${XDG_RUNTIME_DIR}/bus" ]]; then
  say "starting the systemd user manager"
  sudo systemctl start "user@${USER_ID}.service"
fi
[[ -S "${XDG_RUNTIME_DIR}/bus" ]] \
  || die "the systemd user bus was not created at ${XDG_RUNTIME_DIR}/bus"

# v1.9 R-01-3/§5.4: retire the pre-rename unit before the new one is ever
# started, so the two can never run at once and race over the same
# `receiveRoot` / identity file. This runs before the new unit is enabled,
# not after, on purpose.
if systemctl --user list-unit-files "${OLD_UNIT_NAME}" 2>/dev/null | grep -q "${OLD_UNIT_NAME}"; then
  say "found the old ${OLD_UNIT_NAME} unit from a pre-rename install; retiring it"
  systemctl --user stop "${OLD_UNIT_NAME}" 2>/dev/null || true
  systemctl --user disable "${OLD_UNIT_NAME}" 2>/dev/null || true
  rm -f "${UNIT_DIR}/${OLD_UNIT_NAME}"
fi

say "reloading the user manager"
systemctl --user daemon-reload

say "starting the service"
systemctl --user enable --now "${UNIT_NAME}"

say "waiting for the agent to publish a connection code"
CODE_LINE=""
for _ in $(seq 1 20); do
  LINE="$("${BIN_DIR}/lingxi1949" status 2>/dev/null | grep '^code' || true)"
  if [[ -n "${LINE}" && "${LINE}" != *"none"* && "${LINE}" != *"unavailable"* ]]; then
    CODE_LINE="${LINE}"
    break
  fi
  sleep 1
done

echo
echo "Installed and running as $(id -un). Nothing here runs as root after installation."
echo
if [[ -n "${CODE_LINE}" ]]; then
  echo "  ${CODE_LINE}"
  echo
  echo 'Paste that code into LingXi1949'"'"'s "添加设备" in Obsidian.'
else
  echo "Couldn't read the connection code yet (still reaching a relay). Check it with:"
  echo
  echo "  lingxi1949 status"
fi
echo
echo "Useful commands:"
echo "  lingxi1949 status                             show the connection code again"
echo "  journalctl --user -u ${UNIT_NAME} -f        tail the agent's logs"
