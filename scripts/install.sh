#!/usr/bin/env bash
# Install release assets for the current user without changing identity or services.
set -euo pipefail
VERSION=4.0.0
ROLE=''
PREFIX="${HOME}/.local/share/lingxi1949-install"
usage() { echo 'Usage: bash install.sh --role b|c [--prefix ABSOLUTE_PATH]'; }
die() { echo "Install failed: $*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --role) [[ $# -ge 2 ]] || die 'missing role'; ROLE="$2"; shift 2 ;;
    --prefix) [[ $# -ge 2 ]] || die 'missing prefix'; PREFIX="$2"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$ROLE" == b || "$ROLE" == c ]] || die '--role must be b or c'
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || die 'only Linux x64 has a published Agent; use install.ps1 for Windows x64'
[[ "$PREFIX" == /* && "$PREFIX" != / && "$PREFIX" != "$HOME" && "$PREFIX" != *$'\n'* ]] || die 'prefix must be a dedicated absolute directory'
for tool in curl sha256sum tar mktemp; do command -v "$tool" >/dev/null || die "missing dependency: $tool"; done
NODE=''
if [[ "$ROLE" == b ]]; then
  command -v node >/dev/null && command -v npm >/dev/null || die 'B requires Node.js 24+ and npm; install Node.js, then rerun'
  NODE="$(command -v node)"
  "$NODE" -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || die 'B requires Node.js 24+; existing Node was not modified'
fi
umask 077
mkdir -p "$PREFIX"
PREFIX="$(cd "$PREFIX" && pwd -P)"
[[ ! -L "$PREFIX/bin" && ! -L "$PREFIX/bundles" ]] || die 'bin and bundles must not be symlinks'
mkdir -p "$PREFIX/bin" "$PREFIX/bundles"
LOCK="$PREFIX/.install-lock"
mkdir "$LOCK" 2>/dev/null || die "another installer is running (lock: $LOCK)"
STAGE=''
POINTER=''
cleanup() {
  [[ -z "$STAGE" ]] || rm -rf -- "$STAGE"
  [[ -z "$POINTER" ]] || rm -f -- "$POINTER"
  rmdir "$LOCK"
}
trap cleanup EXIT
STAGE="$(mktemp -d "$PREFIX/bundles/${VERSION}-${ROLE}.XXXXXXXX")"
BASE="https://github.com/Cyber-bike1949/LingXi1949/releases/download/$VERSION"
download() {
  local asset="$1" expected actual
  curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 300 --retry 2 "$BASE/$asset" -o "$STAGE/$asset"
  curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 300 --retry 2 "$BASE/$asset.sha256" -o "$STAGE/$asset.sha256"
  read -r expected _ < "$STAGE/$asset.sha256"
  [[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || die "invalid checksum for $asset"
  actual="$(sha256sum "$STAGE/$asset")"
  [[ "${actual%% *}" == "${expected,,}" ]] || die "checksum mismatch: $asset"
}
download lingxi1949-linux-x64
mv "$STAGE/lingxi1949-linux-x64" "$STAGE/lingxi1949"
chmod 755 "$STAGE/lingxi1949"
"$STAGE/lingxi1949" --version
if [[ "$ROLE" == b ]]; then
  download "lingxi-mcp-$VERSION.tar.gz"
  mkdir "$STAGE/mcp"
  tar -xzf "$STAGE/lingxi-mcp-$VERSION.tar.gz" -C "$STAGE/mcp" --no-same-owner
  "$NODE" -e 'const p=require(process.argv[1]); if(p.version!==process.argv[2])process.exit(1)' "$STAGE/mcp/package.json" "$VERSION" || die 'MCP package version mismatch'
  (cd "$STAGE/mcp" && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
  # Keep the executable path, but never initialize the real user profile during checks.
  printf '%s\n' "$NODE" > "$STAGE/node-path"
  "$NODE" "$STAGE/mcp/packages/lingxi-mcp/cli.mjs" --help --home "$STAGE/check-profile"
  rm -rf -- "$STAGE/check-profile"
fi
# Refuse to overwrite files that were not created by this installer.
for name in lingxi1949 lingxi-mcp; do
  if [[ -e "$PREFIX/bin/$name" || -L "$PREFIX/bin/$name" ]]; then
    [[ -f "$PREFIX/bin/$name" && ! -L "$PREFIX/bin/$name" ]] && grep -q '^# LingXi managed launcher v1$' "$PREFIX/bin/$name" || die "unmanaged launcher exists: $PREFIX/bin/$name"
  fi
done
[[ ! -e "$PREFIX/current" || -L "$PREFIX/current" ]] || die 'current is not a managed symlink'
# Launchers use a stable pointer; existing MCP configurations keep their old bundle.
if [[ ! -f "$PREFIX/bin/lingxi1949" ]]; then
  cat > "$PREFIX/bin/lingxi1949" <<'SH'
#!/usr/bin/env bash
# LingXi managed launcher v1
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec "$root/current/lingxi1949" "$@"
SH
  chmod 755 "$PREFIX/bin/lingxi1949"
fi
if [[ ! -f "$PREFIX/bin/lingxi-mcp" ]]; then
  cat > "$PREFIX/bin/lingxi-mcp" <<'SH'
#!/usr/bin/env bash
# LingXi managed launcher v1
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ -f "$root/current/node-path" ]] || { echo 'MCP not installed; rerun installer with --role b' >&2; exit 1; }
node_path="$(< "$root/current/node-path")"
exec "$node_path" "$root/current/mcp/packages/lingxi-mcp/cli.mjs" "$@"
SH
  chmod 755 "$PREFIX/bin/lingxi-mcp"
fi
printf '%s\n' "$VERSION $ROLE" > "$STAGE/installed-version"
POINTER="$PREFIX/.current-$$"
ln -s "$STAGE" "$POINTER"
mv -Tf "$POINTER" "$PREFIX/current"
STAGE=''
POINTER=''
printf '\nInstalled LingXi %s, role %s. Identity/configuration unchanged.\n' "$VERSION" "$ROLE"
printf 'Start Agent (foreground): %q run\n' "$PREFIX/bin/lingxi1949"
[[ "$ROLE" != b ]] || printf 'MCP help: %q --help\n' "$PREFIX/bin/lingxi-mcp"
printf 'Optional PATH for this shell: export PATH=%q:"$PATH"\n' "$PREFIX/bin"
echo 'No service was started. Stop any old Agent before running this one; use the same OS user to retain identity.'
echo 'Next: https://github.com/Cyber-bike1949/LingXi1949/blob/main/docs/remote-tasks-first-run.zh-CN.md'
